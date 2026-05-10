// api/boya.js — Proxy para la Boya de Barcelona (Estacion 12) de Puertos del Estado
// Desplegado como Serverless Function en Vercel
// Acepta query params: ?fecha=YYYYMMDD&hora=HH:MM
// Sin params devuelve el ultimo dato en tiempo real.

// api/boya.js — Proxy Híbrido: Boya Oficial (Live) + Open-Meteo (Histórico)
// Desplegado en Vercel.

// api/boya.js — Proxy Blindado Vercel
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    if (modoHistorico) {
      const lat = 41.38, lon = 2.17;
      const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_period,wave_direction&timezone=Europe/Madrid&start_date=${fecha}&end_date=${fecha}`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`Open-Meteo fallo status ${response.status}`);
      
      const data = await response.json();
      if (!data.hourly || !data.hourly.time || data.hourly.time.length === 0) {
        return res.status(404).json({ error: 'No hay datos para esta fecha.' });
      }

      const targetTimestamp = new Date(`${fecha}T${hora}`).getTime();
      let bestIdx = 0, minDiff = Infinity;

      data.hourly.time.forEach((timeStr, i) => {
        const diff = Math.abs(new Date(timeStr).getTime() - targetTimestamp);
        if (diff < minDiff) { minDiff = diff; bestIdx = i; }
      });

      const hs = data.hourly.wave_height[bestIdx];
      const tp = data.hourly.wave_period[bestIdx];
      const dirGrados = data.hourly.wave_direction[bestIdx];

      return res.status(200).json({
        modo: 'historico_openmeteo',
        hs: hs !== null ? parseFloat(hs.toFixed(2)) : null,
        hmax: hs !== null ? parseFloat((hs * 1.5).toFixed(2)) : null,
        tp: tp !== null ? parseFloat(tp.toFixed(1)) : null,
        dir: gradosACardinal(dirGrados),
        diferenciaMinutos: Math.round(minDiff / 60000),
        fechaHora: data.hourly.time[bestIdx]
      });

    } else {
      let hs = null, hmax = null, tp = null, dirGrados = null, fechaHora = null;

      try {
        const url = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
        const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
        
        if (response.ok) {
          const rawData = await response.json();
          
          let registro = Array.isArray(rawData) ? rawData[0] : rawData;
          
          if (registro) {
            fechaHora = registro.fecha || registro.date || registro.dateTime;
            const listaDatos = registro.datos || registro.measurements || registro.data || (Array.isArray(registro) ? registro : []);

            for (const item of listaDatos) {
              const val = item.valor ?? item.value ?? item.v ?? item.dato;
              if (val !== undefined && val !== null) {
                const id = String(item.paramId || item.idVariable || item.id || "");
                const name = String(item.nombre || item.param || item.variable || item.description || "").toLowerCase();

                if (id === "1" || id === "32" || name.includes("hs") || name.includes("sig")) hs = parseFloat(val);
                else if (id === "2" || id === "33" || name.includes("max") || name.includes("máx")) hmax = parseFloat(val);
                else if (id === "4" || id === "34" || name.includes("tp") || name.includes("pic")) tp = parseFloat(val);
                else if (id === "6" || id === "36" || name.includes("dir") || name.includes("proc")) dirGrados = parseFloat(val);
              }
            }
          }
        }
      } catch (e) {
        console.warn("Fallo en Puertos del Estado, activando Open-Meteo.");
      }

      if (hs === null && tp === null) {
        const lat = 41.38, lon = 2.17;
        const omUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_period,wave_direction&timezone=Europe/Madrid`;
        const omRes = await fetch(omUrl);
        if (omRes.ok) {
          const omData = await omRes.json();
          hs = omData.current.wave_height;
          tp = omData.current.wave_period;
          dirGrados = omData.current.wave_direction;
          hmax = hs ? hs * 1.5 : null;
          fechaHora = omData.current.time;
        }
      }

      return res.status(200).json({
        modo: hs !== null ? 'live' : 'error',
        hs: hs !== null ? parseFloat(hs.toFixed(2)) : null,
        hmax: hmax !== null ? parseFloat(hmax.toFixed(2)) : null,
        tp: tp !== null ? parseFloat(tp.toFixed(1)) : null,
        dir: gradosACardinal(dirGrados),
        fechaHora: fechaHora || new Date().toISOString()
      });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

function gradosACardinal(grados) {
  if (grados === null || isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  let calc = grados / 360;
  let normalized = (calc - Math.floor(calc)) * 360;
  let idx = Math.round(normalized / 45);
  if (idx === 8) idx = 0;
  return rumbos[idx];
}
