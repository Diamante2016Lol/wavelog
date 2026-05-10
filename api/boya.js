// api/boya.js — Proxy para la Boya de Barcelona (Estacion 12) de Puertos del Estado
// Desplegado como Serverless Function en Vercel
// Acepta query params: ?fecha=YYYYMMDD&hora=HH:MM
// Sin params devuelve el ultimo dato en tiempo real.

// api/boya.js — Proxy Híbrido: Boya Oficial (Live) + Open-Meteo (Histórico)
// Desplegado en Vercel.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    if (modoHistorico) {
      // ---------------------------------------------------------
      // MODO HISTÓRICO: Open-Meteo (Fiabilidad 100% para el pasado)
      // ---------------------------------------------------------
      const lat = 41.38;
      const lon = 2.17;
      
      const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_period,wave_direction,wave_height_max&timezone=Europe%2FMadrid&start_date=${fecha}&end_date=${fecha}`;

      const response = await fetch(url);
      if (!response.ok) throw new Error('Error al consultar Open-Meteo');
      
      const data = await response.json();

      if (!data.hourly || !data.hourly.time || data.hourly.time.length === 0) {
        return res.status(404).json({ error: 'No hay datos para esta fecha.' });
      }

      const targetTimestamp = new Date(`${fecha}T${hora}`).getTime();
      let bestIdx = 0;
      let minDiff = Infinity;

      data.hourly.time.forEach((timeStr, i) => {
        const diff = Math.abs(new Date(timeStr).getTime() - targetTimestamp);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = i;
        }
      });

      const diferenciaMinutos = Math.round(minDiff / 60000);

      const hs = data.hourly.wave_height[bestIdx];
      const tp = data.hourly.wave_period[bestIdx];
      const hmax = data.hourly.wave_height_max[bestIdx];
      const dirGrados = data.hourly.wave_direction[bestIdx];

      return res.status(200).json({
        modo: 'historico_openmeteo',
        hs: hs !== null ? parseFloat(hs.toFixed(2)) : null,
        hmax: hmax !== null ? parseFloat(hmax.toFixed(2)) : null,
        tp: tp !== null ? parseFloat(tp.toFixed(1)) : null,
        dir: gradosACardinal(dirGrados),
        diferenciaMinutos: diferenciaMinutos,
        fechaHora: data.hourly.time[bestIdx]
      });

    } else {
      // ---------------------------------------------------------
      // MODO LIVE: Puertos del Estado (La URL secreta cazada)
      // ---------------------------------------------------------
      const url = 'https://portus.puertos.es/portussvr/api/lastData/positions/1731';
      
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });

      if (!response.ok) {
        throw new Error(`Puertos del Estado devolvió status ${response.status}`);
      }

      const rawData = await response.json();
      const list = Array.isArray(rawData) ? rawData : (rawData.data || rawData.measurements || []);

      if (list.length === 0) {
         throw new Error('Respuesta vacía de la boya');
      }

      let hs = null, hmax = null, tp = null, dirGrados = null, fechaHora = null;

      // Analizador dinámico para atrapar los datos vengan como vengan
      for (const item of list) {
        const id = item.paramId || item.idVariable || item.param || item.id;
        const val = item.valor !== undefined ? item.valor : item.value;
        const time = item.fechaHora || item.dateTime || item.date;

        if (id == 1) { hs = val; if (time) fechaHora = time; }
        if (id == 2) { hmax = val; }
        if (id == 4) { tp = val; }
        if (id == 6) { dirGrados = val; }
      }

      return res.status(200).json({
        modo: 'live_puertos',
        hs: hs !== null ? parseFloat(parseFloat(hs).toFixed(2)) : null,
        hmax: hmax !== null ? parseFloat(parseFloat(hmax).toFixed(2)) : null,
        tp: tp !== null ? parseFloat(parseFloat(tp).toFixed(1)) : null,
        dir: gradosACardinal(dirGrados),
        fechaHora: fechaHora || new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('[api/boya] Error:', error.message);
    return res.status(500).json({
      error: 'Fallo interno en el proxy.',
      detalle: error.message
    });
  }
}

function gradosACardinal(grados) {
  if (grados === null || isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const indice = Math.round(((grados % 360) + 360) % 360 / 45) % 8;
  return rumbos[indice];
}
