// api/boya.js — Proxy para la Boya de Barcelona (Estacion 12) de Puertos del Estado
// Desplegado como Serverless Function en Vercel
// Acepta query params: ?fecha=YYYYMMDD&hora=HH:MM
// Sin params devuelve el ultimo dato en tiempo real.

export default async function handler(req, res) {
  // Cabeceras CORS para que el frontend pueda llamar a este endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // IDs de variables de la boya segun Puertos del Estado:
  // 1 = Hs (altura significativa), 2 = Hmax, 4 = Tp (periodo pico), 6 = Direccion
  const STATION_ID = 12;
  const VAR_IDS = [1, 2, 4, 6];

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    if (modoHistorico) {
      // --- MODO HISTORICO ---
      // Consultamos el historico del dia solicitado y buscamos la medicion mas cercana a la hora dada

      // Construimos la fecha en formato YYYYMMDD
      const fechaStr = fecha.replace(/-/g, ''); // admite tanto YYYY-MM-DD como YYYYMMDD

      // URL del servicio de datos historicos de Puertos del Estado
      // Devuelve un JSON con todas las mediciones del dia para la estacion y variables dadas
      const variablesParam = VAR_IDS.join(',');
      const url = `https://portus.puertos.es/portushin/rest/measurements/station/${STATION_ID}/variables/${variablesParam}/date/${fechaStr}`;

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'WaveLog/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Puertos del Estado respondio con status ${response.status}`);
      }

      const rawData = await response.json();

      // Parseamos la hora objetivo a minutos desde medianoche para comparar
      const [horaObj, minObj] = hora.split(':').map(Number);
      const minutosObjetivo = horaObj * 60 + minObj;

      // La API devuelve un array de mediciones. Cada medicion tiene:
      // { dateTime: "YYYY-MM-DDTHH:MM:SSZ", measurements: [ { idVariable: N, value: X }, ... ] }
      if (!Array.isArray(rawData) || rawData.length === 0) {
        return res.status(404).json({ error: 'No hay datos historicos para esta fecha.' });
      }

      // Encontramos la medicion mas cercana en tiempo a la hora solicitada
      let mejorMedicion = null;
      let menorDiferencia = Infinity;

      for (const entry of rawData) {
        if (!entry.dateTime) continue;
        const dtParts = entry.dateTime.split('T');
        if (!dtParts[1]) continue;
        const timeParts = dtParts[1].replace('Z', '').split(':');
        const h = parseInt(timeParts[0], 10);
        const m = parseInt(timeParts[1], 10);
        const minutosEntrada = h * 60 + m;
        const diff = Math.abs(minutosEntrada - minutosObjetivo);
        if (diff < menorDiferencia) {
          menorDiferencia = diff;
          mejorMedicion = entry;
        }
      }

      if (!mejorMedicion) {
        return res.status(404).json({ error: 'No se encontro medicion cercana.' });
      }

      const resultado = extraerVariables(mejorMedicion.measurements);
      resultado.fechaHora = mejorMedicion.dateTime;
      resultado.modo = 'historico';
      resultado.diferenciaMinutos = menorDiferencia;

      return res.status(200).json(resultado);

    } else {
      // --- MODO TIEMPO REAL ---
      // Consultamos el ultimo dato disponible de la boya
      const variablesParam = VAR_IDS.join(',');
      const url = `https://portus.puertos.es/portushin/rest/measurements/station/${STATION_ID}/variables/${variablesParam}/last`;

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'WaveLog/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Puertos del Estado respondio con status ${response.status}`);
      }

      const rawData = await response.json();

      // En modo live la API devuelve directamente un objeto o un array de un solo elemento
      const measurements = Array.isArray(rawData)
        ? rawData[0]?.measurements
        : rawData.measurements;

      if (!measurements) {
        throw new Error('Formato de respuesta inesperado de Puertos del Estado');
      }

      const fechaHora = Array.isArray(rawData) ? rawData[0]?.dateTime : rawData.dateTime;
      const resultado = extraerVariables(measurements);
      resultado.fechaHora = fechaHora || new Date().toISOString();
      resultado.modo = 'live';

      return res.status(200).json(resultado);
    }

  } catch (error) {
    console.error('[api/boya] Error:', error.message);
    return res.status(500).json({
      error: 'No se pudieron obtener datos de Puertos del Estado.',
      detalle: error.message
    });
  }
}

// Extrae y mapea las variables de interes desde el array de measurements de la API
function extraerVariables(measurements) {
  const map = {};
  if (Array.isArray(measurements)) {
    for (const m of measurements) {
      map[m.idVariable] = m.value;
    }
  }

  // Convertimos la direccion en grados a punto cardinal (8 rumbos)
  const dirGrados = parseFloat(map[6]);
  const puntoCardinal = gradosACardinal(dirGrados);

  return {
    hs:  map[1] !== undefined ? parseFloat(parseFloat(map[1]).toFixed(2)) : null,
    hmax: map[2] !== undefined ? parseFloat(parseFloat(map[2]).toFixed(2)) : null,
    tp:  map[4] !== undefined ? parseFloat(parseFloat(map[4]).toFixed(1)) : null,
    dirGrados: isNaN(dirGrados) ? null : Math.round(dirGrados),
    dir: puntoCardinal
  };
}

// Convierte grados a punto cardinal de 8 rumbos
function gradosACardinal(grados) {
  if (isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const indice = Math.round(((grados % 360) + 360) % 360 / 45) % 8;
  return rumbos[indice];
}
